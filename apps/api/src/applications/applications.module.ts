import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { ApplicationsController } from './applications.controller.js';
import { ApplicationsService } from './applications.service.js';

/**
 * The public application form from the marketing site at libriant.com.
 *
 * Auth-free by design; see the controller for why each behaviour is shaped the
 * way it is. EmailModule supplies the durable notification; RateLimitService
 * comes from the @Global RedisModule and needs no import here.
 */
@Module({
  imports: [EmailModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
})
export class ApplicationsModule {}
