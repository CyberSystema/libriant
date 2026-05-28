import { Module } from '@nestjs/common';
import { HelpController } from './help.controller.js';
import { HelpService } from './help.service.js';

@Module({
  providers: [HelpService],
  controllers: [HelpController],
  exports: [HelpService],
})
export class HelpModule {}
