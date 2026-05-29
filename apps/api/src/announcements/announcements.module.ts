import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { AdminAnnouncementsController } from './admin-announcements.controller.js';
import { AdminTenantTagsController } from './admin-tenant-tags.controller.js';
import { AnnouncementDeliveryService } from './announcement-delivery.service.js';
import { AnnouncementService } from './announcement.service.js';
import { TenantAnnouncementsController } from './tenant-announcements.controller.js';

/**
 * Announcement subsystem (Step 18b): admin composes + targets, library
 * fetches active set + dismisses / acknowledges, plus the per-tenant tag
 * editor used for audience targeting.
 *
 * Email delivery flows through `EmailService` (Step 18d), which writes to
 * the durable `email_outbox` table and queues a BullMQ job for the worker
 * to drain. Scheduled upfront materialization of in-app deliveries is
 * still deferred — for MVP we materialize lazily on first fetch.
 */
@Module({
  imports: [AdminModule, TenantModule],
  providers: [AnnouncementService, AnnouncementDeliveryService],
  controllers: [
    AdminAnnouncementsController,
    AdminTenantTagsController,
    TenantAnnouncementsController,
  ],
  exports: [AnnouncementService, AnnouncementDeliveryService],
})
export class AnnouncementsModule {}
