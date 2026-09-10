import { Module } from '@nestjs/common';
import { HoldArrivalService } from './hold-arrival.service.js';

/**
 * The one question `ItemsModule` has to ask `HoldsModule` (2.0 phase 17).
 *
 * ## Why a module exists for one service
 *
 * `HoldsModule` imports `ItemsModule` — it needs `ItemStatusService` to shelve a
 * copy and `ItemTransfersService` to route one — so `ItemsModule` cannot import
 * `HoldsModule` back without a `forwardRef` cycle. And it has to ask: a transit
 * desk scans a barcode and does not know whether the copy in its hand is a hold
 * arrival, a float or a repair return, so ONE route answers for all three.
 *
 * `forwardRef` would work and is the wrong tool. It makes the cycle invisible,
 * it defers the failure to runtime, and it would let any part of holds reach
 * into items and vice versa — where the actual dependency is one method that
 * needs nothing but the caller's transaction.
 *
 * So the question moves into a module that imports NOTHING and both sides
 * import IT. The absence of an `imports` array below is the whole design: a
 * future edit that gives `HoldArrivalService` a constructor dependency has to
 * add one, and adding one is visible in review.
 */
@Module({
  providers: [HoldArrivalService],
  exports: [HoldArrivalService],
})
export class HoldArrivalModule {}
