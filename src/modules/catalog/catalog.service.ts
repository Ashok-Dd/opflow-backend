import { Injectable } from '@nestjs/common';

import { DbService } from '../../infra/db/db.service';
import { buildCatalog, Catalog } from './catalog.builder';

const CACHE_MS = 60_000;

/**
 * The catalog changes rarely (admins edit it), so it is cached in memory for a minute per process.
 * (At B5 this moves to Redis so every instance sees admin changes at the same moment.)
 */
@Injectable()
export class CatalogService {
  private cache?: { at: number; value: Catalog };
  private inflight?: Promise<Catalog>;

  constructor(private readonly dbs: DbService) {}

  async get(): Promise<Catalog> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    // Many requests at the same moment share one database read.
    this.inflight ??= this.load()
      .then((value) => {
        this.cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async load(): Promise<Catalog> {
    const db = this.dbs.db;
    const [types, problems, problemMap, kinds, kindTypes, firstAid, config] = await Promise.all([
      db.selectFrom('doctorTypes').select(['id', 'simpleName', 'properName', 'icon', 'sort', 'isCommon']).execute(),
      db.selectFrom('healthProblems').select(['id', 'name', 'icon', 'isDanger', 'sort']).execute(),
      db.selectFrom('problemTypeMap').select(['problemId', 'typeId', 'audience', 'rank']).execute(),
      db.selectFrom('emergencyKinds').select(['id', 'name', 'detail', 'icon', 'sort']).execute(),
      db.selectFrom('emergencyKindTypes').select(['kindId', 'typeId']).execute(),
      db
        .selectFrom('firstAidGuides')
        .select(['kindId', 'intro', 'signs', 'callNowIf', 'dos', 'donts', 'sources', 'reviewedByDoctor', 'reviewedAt'])
        .where('status', '=', 'published')
        .execute(),
      db.selectFrom('appConfig').select(['key', 'value']).execute(),
    ]);
    return buildCatalog({ types, problems, problemMap, kinds, kindTypes, firstAid, config });
  }
}
