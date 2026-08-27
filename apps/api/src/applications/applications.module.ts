import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { AdminApplicationsController } from './admin-applications.controller.js';
import { ApplicationsController } from './applications.controller.js';
import { ApplicationsService } from './applications.service.js';

/**
 * The public application form from the marketing site at libriant.com, and the
 * admin panel's view of what it collected.
 *
 * Auth-free by design on the public side; see the controller for why each
 * behaviour is shaped the way it is. EmailModule supplies the durable
 * notification; RateLimitService comes from the @Global RedisModule and needs
 * no import here.
 *
 * `AdminApplicationsController` is registered HERE rather than in AdminModule
 * because it belongs to the funnel, not to the admin plane's plumbing — and
 * because a controller that is never listed in a module's `controllers` array
 * is a set of routes Nest never maps, which is exactly the shape of an
 * "endpoint that exists and is never requested". It carries its own
 * AdminAuthGuard + AdminRolesGuard, so nothing about the gate depends on which
 * module holds it.
 */
@Module({
  imports: [EmailModule],
  controllers: [ApplicationsController, AdminApplicationsController],
  providers: [ApplicationsService],
})
export class ApplicationsModule {}
