import { Global, Module } from '@nestjs/common';

import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';

@Global()
@Module({ controllers: [DirectoryController], providers: [DirectoryService], exports: [DirectoryService] })
export class DirectoryModule {}
