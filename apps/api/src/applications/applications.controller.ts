import { All, Controller, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { renderIndex, localePath, ERRORS, type Lang, type SiteConfig } from '@libriant/site';
import siteConfigRaw from '@libriant/site/site.config.json' with { type: 'json' };
import landingEl from '../../../../locales/el/landing.json' with { type: 'json' };
import landingEn from '../../../../locales/en/landing.json' with { type: 'json' };
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { neutralizeFormula } from '../export/export-processors.js';
import { clientIp } from '../platform/client-ip.js';
import { ApplicationsService, type Parsed } from './applications.service.js';

const config = siteConfigRaw as unknown as SiteConfig;
const LANDING: Record<Lang, Record<string, string>> = {
  el: landingEl as Record<string, string>,
  en: landingEn as Record<string, string>,
};

/**
 * The version of the privacy notice on screen at submission time. Read from the
 * same file the static build reads, so the recorded version and the displayed
 * one cannot drift.
 */
const PRIVACY_VERSION = config.legal.lastUpdated;

/**
 * The marketing site's application form.
 *
 * Auth-free on purpose — this is a form for strangers, and it is the only
 * unauthenticated write in the control plane. It replaces the Cloudflare Worker
 * the site used to ship; every behaviour below is ported deliberately, so read
 * the comments before simplifying any of it.
 *
 * Responses are HTML, not JSON: the site ships zero JavaScript, so a failed
 * submission has to come back as the real page with the visitor's answers still
 * in it. Every handler therefore takes `@Res()` so the global JSON exception
 * filter never touches these responses.
 */
@Controller()
export class ApplicationsController {
  constructor(@Inject(ApplicationsService) private readonly svc: ApplicationsService) {}

  @Post(['apply', 'en/apply'])
  async apply(@Req() req: Request, @Res() res: Response): Promise<void> {
    const lang = langOf(req.path);
    const E = ERRORS[lang];
    const home = localePath(lang, '/');

    // Closed offer: bounce before touching anything the visitor sent.
    if (config.offer.spotsRemaining <= 0) {
      res.redirect(303, `${home}#apply`);
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object') {
      this.send(res, 400, lang, { values: {}, errors: {} }, E.invalidSubmission);
      return;
    }

    // Honeypot: a field hidden off-screen and marked aria-hidden. A human never
    // fills it; naive scrapers fill every input they find. Answer exactly as for
    // a success so the bot learns nothing from the difference — never 400 it.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      res.redirect(303, localePath(lang, '/thank-you'));
      return;
    }

    const parsed = this.svc.validate(body, E);

    if (Object.keys(parsed.errors).length > 0) {
      this.send(res, 400, lang, parsed, E.checkFields);
      return;
    }

    // Throttle AFTER validation, exactly where the Worker had it: an honest
    // typo should not burn someone's hourly budget. Fails open — a Redis
    // outage must never eat a lead.
    if (await this.svc.isRateLimited(clientIp(req))) {
      this.send(res, 429, lang, parsed, E.rateLimited);
      return;
    }

    let id: string;
    try {
      id = await this.svc.save(parsed, PRIVACY_VERSION);
    } catch {
      // The commit point failed. Still try to get the lead into the inbox, and
      // tell the applicant honestly how else to reach us.
      await this.svc.notify('unsaved', parsed).catch(() => undefined);
      this.send(res, 500, lang, parsed, E.saveFailed(config.identity.contactEmail));
      return;
    }

    // Best-effort from here on. The application is already committed.
    await this.svc.notify(id, parsed).catch(() => undefined);
    res.redirect(303, localePath(lang, '/thank-you'));
  }

  /** Stray navigation to the form's action lands back on the form. */
  @Get(['apply', 'en/apply'])
  redirectToForm(@Req() req: Request, @Res() res: Response): void {
    res.redirect(303, `${localePath(langOf(req.path), '/')}#apply`);
  }

  @All(['apply', 'en/apply'])
  notAllowed(@Res() res: Response): void {
    res.status(405).set('allow', 'POST').type('text/plain').send('Method not allowed');
  }

  /**
   * The applications export, behind an admin session rather than a shared
   * token: a `?token=` lands in Caddy's access log, which the nightly backup
   * archives.
   */
  @Get('admin/applications.csv')
  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  async exportCsv(@Res() res: Response): Promise<void> {
    const cols = [
      'created_at',
      'library_name',
      'library_type',
      'city',
      'contact_name',
      'contact_email',
      'phone',
      'collection_size',
      'current_system',
      'message',
      'status',
      'notified',
      'id',
    ] as const;

    const rows = await controlDb.application.findMany({ orderBy: { createdAt: 'desc' } });
    const cell = (v: unknown): string => {
      const raw = v == null ? '' : String(v);
      return `"${neutralizeFormula(raw).replace(/"/g, '""')}"`;
    };
    const lines = [
      cols.join(','),
      ...rows.map((r) =>
        [
          cell(r.createdAt.toISOString()),
          cell(r.libraryName),
          cell(r.libraryType),
          cell(r.city),
          cell(r.contactName),
          cell(r.contactEmail),
          cell(r.phone),
          cell(r.collectionSize),
          cell(r.currentSystem),
          cell(r.message),
          cell(r.status),
          cell(r.notified),
          cell(r.id),
        ].join(','),
      ),
    ];

    res
      .status(200)
      .set({
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="libriant-applications.csv"',
        'cache-control': 'no-store',
      })
      // BOM so Excel reads the Greek as UTF-8 instead of mojibake.
      .send('﻿' + lines.join('\r\n') + '\r\n');
  }

  /** Re-render the real page with the visitor's answers and inline errors. */
  private send(res: Response, status: number, lang: Lang, parsed: Parsed, formError: string): void {
    res
      .status(status)
      .type('text/html; charset=utf-8')
      .send(
        renderIndex(config, LANDING[lang], {
          lang,
          errors: parsed.errors,
          values: parsed.values,
          formError,
        }),
      );
  }
}

/** `/en/apply` is English; everything else is Greek. Mirrors the site's routing. */
function langOf(pathname: string): Lang {
  return pathname === '/en/apply' || pathname.startsWith('/en/') ? 'en' : 'el';
}
