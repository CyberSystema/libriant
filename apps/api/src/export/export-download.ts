import { promises as fs } from 'node:fs';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { ExportJob } from '@libriant/db-control';

/** Stream a completed export's file as a download. Ownership is checked by the
 *  caller; this only validates readiness + that the file still exists. */
export async function streamExport(res: Response, job: ExportJob): Promise<void> {
  if (job.status !== 'completed' || !job.filePath) {
    throw new BadRequestException('This export isn’t ready to download yet.');
  }
  try {
    await fs.access(job.filePath);
  } catch {
    throw new NotFoundException(
      'This export file is no longer available — please run a new export.',
    );
  }
  res.download(job.filePath, job.fileName ?? 'libriant-export');
}
