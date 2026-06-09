import { IsBoolean } from 'class-validator';

export class SetSubscriptionsEnabledDto {
  /** true = enforce plans + Stripe; false = everything free for every tenant. */
  @IsBoolean()
  enabled!: boolean;
}
