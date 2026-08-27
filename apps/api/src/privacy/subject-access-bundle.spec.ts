import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { ROLES_KEY } from '../tenancy/roles.decorator.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { SubjectAccessController } from './subject-access.controller.js';
import {
  AGE_OF_MAJORITY_YEARS,
  assessMinor,
  completedYears,
  noticeIsAboutSubject,
  subjectAccessFilename,
} from './subject-access-bundle.js';

/**
 * privacy-legal-15 and privacy-legal-12, for the decisions that do not need a
 * database. The end-to-end behaviour (a real signup, a real member, a real HTTP
 * GET) is exercised against a booted API; what is pinned here is the handful of
 * pure judgements where being wrong discloses the wrong person's data.
 */

describe('shared-mailbox filter (privacy-legal-15)', () => {
  const mine = new Set(['loan-mine']);
  const myHolds = new Set(['res-mine']);

  it('drops a notice about somebody else’s loan sent to the same address', () => {
    // The scenario the DPIA pack creates on purpose: a parent's mailbox on two
    // pupils' member records. Matching on `toEmail` alone — which is how
    // erasure finds these rows — would put the brother's overdue notice, book
    // title included, into the sister's Article 15 answer.
    expect(noticeIsAboutSubject({ loanId: 'loan-sibling' }, mine, myHolds)).toBe(false);
    expect(noticeIsAboutSubject({ reservationId: 'res-sibling' }, mine, myHolds)).toBe(false);
  });

  it('keeps a notice about this member’s own loan or hold', () => {
    expect(noticeIsAboutSubject({ loanId: 'loan-mine' }, mine, myHolds)).toBe(true);
    expect(noticeIsAboutSubject({ reservationId: 'res-mine' }, mine, myHolds)).toBe(true);
  });

  it('keeps a notice that names neither, rather than under-answering', () => {
    expect(noticeIsAboutSubject({}, mine, myHolds)).toBe(true);
    expect(noticeIsAboutSubject(null, mine, myHolds)).toBe(true);
    expect(noticeIsAboutSubject({ announcementId: 'a1' }, mine, myHolds)).toBe(true);
  });

  it('does not treat a non-string id as a match', () => {
    expect(noticeIsAboutSubject({ loanId: 42 }, mine, myHolds)).toBe(true);
  });
});

describe('age assessment (privacy-legal-12)', () => {
  const on = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('is still a minor the day before the eighteenth birthday, and not on it', () => {
    const dob = on('2008-08-27');
    expect(assessMinor(dob, 'school', on('2026-08-26')).isMinor).toBe(true);
    expect(assessMinor(dob, 'school', on('2026-08-27')).isMinor).toBe(false);
    expect(completedYears(dob, on('2026-08-27'))).toBe(AGE_OF_MAJORITY_YEARS);
  });

  it('reports UNKNOWN rather than "not a minor" when no date of birth is on file', () => {
    // The column is optional and the DPIA pack tells school libraries to leave
    // it blank unless they need it. Defaulting the flag to `false` would print
    // "adult" over every pupil in exactly the libraries this exists for.
    const a = assessMinor(null, 'public', on('2026-08-27'));
    expect(a.isMinor).toBeNull();
    expect(a.basis).toBe('no_date_of_birth');
    expect(a.presumedChild).toBe(false);
  });

  it('presumes a child in a school library with no date of birth', () => {
    const a = assessMinor(null, 'school', on('2026-08-27'));
    expect(a.isMinor).toBeNull();
    expect(a.presumedChild).toBe(true);
  });

  it('handles a leap-day birthday without claiming an extra year', () => {
    const dob = on('2008-02-29');
    expect(completedYears(dob, on('2026-02-28'))).toBe(17);
    expect(completedYears(dob, on('2026-03-01'))).toBe(18);
  });
});

describe('download filename', () => {
  it('names the library and the membership number, never the person', () => {
    const name = subjectAccessFilename('dimotiki-larisas', 'M-2026-0001', new Date('2026-08-27'));
    expect(name).toBe('libriant-dimotiki-larisas-M-2026-0001-2026-08-27.json');
  });

  it('cannot smuggle a path or a quote into the Content-Disposition header', () => {
    const name = subjectAccessFilename('../../etc', 'a"b/c', new Date('2026-08-27'));
    expect(name).not.toMatch(/["/\\]/);
    expect(name.startsWith('libriant-')).toBe(true);
  });
});

describe('route wiring (privacy-legal-15)', () => {
  const proto = SubjectAccessController.prototype as unknown as Record<string, unknown>;
  const handler = proto.dataExport as object;

  it('is mounted at GET t/:slug/members/:id/data-export', () => {
    expect(Reflect.getMetadata('path', SubjectAccessController)).toBe('t/:slug/members');
    expect(Reflect.getMetadata('path', handler)).toBe(':id/data-export');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.GET);
  });

  it('is behind the tenant + role guards, and closed to volunteers', () => {
    const guards = Reflect.getMetadata('__guards__', SubjectAccessController) as unknown[];
    expect(guards).toContain(TenantGuard);
    expect(guards).toContain(RolesGuard);
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect(roles).toEqual(['owner', 'admin', 'librarian']);
    expect(roles).not.toContain('volunteer');
  });
});
