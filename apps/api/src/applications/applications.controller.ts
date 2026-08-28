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

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object') {
      this.send(res, 400, lang, { values: {}, errors: {} }, E.invalidSubmission);
      return;
    }

    // Honeypot: a field hidden off-screen and marked aria-hidden. A human never
    // fills it; naive scrapers fill every input they find. Answer exactly as for
    // a success so the bot learns nothing from the difference — never 400 it.
    //
    // FIRST, ahead of the offer-state query below. It used to sit after it, so
    // every form-spam crawler — the exact caller this branch exists to discard
    // for nothing — took a control-plane connection and ran a COUNT before
    // anything looked at whether it was a bot. Nothing here needs the offer
    // state: a bot gets the same 303 whether the offer is open or shut, which
    // is the "learns nothing from the difference" property this branch wants.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      res.redirect(303, this.thankYou(lang));
      return;
    }

    // Closed offer: answer before touching anything else the visitor sent.
    //
    // launch-readiness-11, both halves. The condition was
    // `config.offer.spotsRemaining <= 0` — a literal compiled into this file,
    // so closing the form was a commit, a CI run and an on-box deploy, and
    // until that landed the sixth applicant was accepted by a form that should
    // have shut. It now asks the applications table, which the admin panel
    // writes: accepting the fifth library closes the form that minute.
    //
    // And the answer is the page, not a redirect. The bounce went to
    // `/#apply` — the static home page, which still renders the form, because
    // a file written at deploy time cannot know the places are gone. A library
    // that had just typed nine answers got them back empty with no
    // explanation. They now get the real waiting-list notice, with the address
    // to write to, on a 200: nothing failed at their end, and an offer filling
    // up must not light up whatever watches this host for 4xx.
    const offer = await this.svc.offerState();
    if (!offer.open) {
      this.sendClosed(res, lang);
      return;
    }

    const parsed = this.svc.validate(body, E);

    if (Object.keys(parsed.errors).length > 0) {
      this.send(res, 400, lang, parsed, E.checkFields);
      return;
    }

    // Throttle AFTER validation, exactly where the Worker had it: an honest
    // typo should not burn someone's hourly budget. The per-visitor bucket
    // still fails open — a Redis outage must never eat a lead — with a
    // platform-wide ceiling behind it (input-and-files-10) that an unreachable
    // Redis hands to a per-instance counter rather than to the visitor.
    const verdict = await this.svc.throttle(clientIp(req));
    if (verdict !== 'ok') {
      // A 'global' refusal is not this visitor's doing, so don't answer them
      // with "we have already had several submissions from you" — that reads as
      // an accusation and tells them to wait an hour for something that may
      // clear in seconds. The honest copy we have names the escape hatch (write
      // to us at this address); a string of its own belongs in
      // apps/site/src/copy.ts alongside the others.
      const message = verdict === 'ip' ? E.rateLimited : E.saveFailed(config.identity.contactEmail);
      this.send(res, 429, lang, parsed, message);
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
    res.redirect(303, this.thankYou(lang));
  }

  /**
   * Where a successful submission lands, fragment and all.
   *
   * The form posts to `/apply#form-error` so that a REJECTED submission scrolls
   * to the reason and focuses it (apps/site/src/pages.ts explains why that is
   * the only no-JS way to do it). A redirect inherits the request URL's
   * fragment, so without naming one here the thank-you page would open scrolled
   * to an anchor it does not have. `#main` is the skip-link target every page
   * already carries, so success lands on the page's own content.
   */
  private thankYou(lang: Lang): string {
    return `${localePath(lang, '/thank-you')}#main`;
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
      // The ISO code, not the label — the same choice `library_type` makes by
      // exporting the enum value. A code is the stable key a spreadsheet can
      // sort and join on, and CLDR renames the labels underneath exports that
      // were saved months apart (Turkey → Türkiye).
      'country',
      'contact_name',
      'contact_email',
      // Already composed as `+30 2410000000` on the way into the row, so this
      // is one cell an operator can dial, not two they have to join.
      'phone',
      'collection_size',
      'current_system',
      'message',
      'status',
      'notified',
      'id',
    ] as const;

    const rows = await controlDb.application.findMany({ orderBy: { createdAt: 'desc' } });
    // `neutralizeFormula` now fires on every phone, because a dialable number
    // starts with `+` and Excel reads a leading `+` as the start of a formula
    // (inherited from Lotus). Left alone, `+30 2410000000` is evaluated rather
    // than displayed and the operator gets an error where the number should be;
    // the apostrophe it prefixes forces the cell to text, which is the number
    // back. Worth recording that the `+` is OURS — it comes from the canonical
    // dial list, so the applicant's own text can never be the first character
    // of that cell — and that this is therefore the guard doing its job on a
    // value we compose, not a hole being papered over.
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
          cell(r.country),
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

  /** The home page with the waiting-list notice where the form usually is. */
  private sendClosed(res: Response, lang: Lang): void {
    res
      .status(200)
      .type('text/html; charset=utf-8')
      .set('cache-control', 'no-store')
      .send(renderIndex(config, LANDING[lang], { lang, offerClosed: true }));
  }

  /** Re-render the real page with the visitor's answers and inline errors. */
  /**
   * The visitor's answers, back on the page they came from.
   *
   * `no-store` is set here and not only at the edge. infra/caddy/Caddyfile puts
   * `header_down Cache-Control "no-store"` on the marketing vhost's `@apply`
   * block, with a comment about this being the page that carries a named
   * librarian's email address and telephone number back to them — but that
   * matcher is not the only entrance. `app.<apex>/lbr-api/apply` proxies to this
   * same handler through a `handle_path` block that sets no headers at all,
   * which is the /webhooks/* shape the edge config's own comments are about. On
   * the response, a third entrance cannot lose it.
   */
  private send(res: Response, status: number, lang: Lang, parsed: Parsed, formError: string): void {
    res
      .status(status)
      .type('text/html; charset=utf-8')
      .set('cache-control', 'no-store')
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
