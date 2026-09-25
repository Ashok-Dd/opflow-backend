import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/auth/auth.decorators';

import { CatalogService } from './catalog.service';

@Public()
@ApiTags('catalog')
@Controller('v1/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Everything the app needs to draw its menus, in one call at startup: types of doctor, health problems
   * (with the doctors for adults and children), emergency situations (with published first aid), the public
   * rules, kill switches and app versions. Public: no login needed (Emergency works before login).
   * The response has an ETag, so an unchanged catalog costs the phone almost nothing to re-check.
   */
  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOkResponse({ description: 'The catalog' })
  get() {
    return this.catalog.get();
  }
}
