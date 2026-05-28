import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { HelpService } from './help.service.js';

/**
 * Help center — bundled markdown KB indexed via Postgres FTS.
 *
 *   GET /help/articles?locale=el&q=κρατησεις
 *   GET /help/articles/:slug?locale=el
 *
 * Auth-free on purpose: help content is shared across all tenants and is
 * useful even on the login/signup pages. There are no per-tenant articles
 * (would be a Pro/Enterprise feature, not MVP).
 */
@Controller('help')
export class HelpController {
  constructor(@Inject(HelpService) private readonly svc: HelpService) {}

  @Get('articles')
  async list(
    @Query('locale') locale?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({
      locale,
      q,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Get('articles/:slug')
  async get(@Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.svc.get({ slug, locale });
  }
}
