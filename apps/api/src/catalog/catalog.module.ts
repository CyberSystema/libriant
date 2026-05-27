import { Module } from '@nestjs/common';
import { CustomizationModule } from '../customization/customization.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { AuthorsController } from './authors.controller.js';
import { AuthorsService } from './authors.service.js';
import { BooksController } from './books.controller.js';
import { BooksService } from './books.service.js';
import { CopiesController } from './copies.controller.js';
import { CopiesService } from './copies.service.js';
import { CoversController } from './covers.controller.js';
import { IsbnController } from './isbn.controller.js';
import { IsbnLookupService } from './isbn.service.js';

@Module({
  imports: [TenantModule, PlansModule, CustomizationModule, StorageModule],
  providers: [AuthorsService, BooksService, CopiesService, IsbnLookupService],
  controllers: [
    AuthorsController,
    BooksController,
    CopiesController,
    CoversController,
    IsbnController,
  ],
  exports: [AuthorsService, BooksService, CopiesService, IsbnLookupService],
})
export class CatalogModule {}
