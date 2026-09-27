import { Global, Module } from '@nestjs/common';

import { BookingsController } from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
import { LiveController } from './live/live.controller';
import { LiveGateway } from './live/live.gateway';
import { LiveService } from './live/live.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { AdminPicksController, PicksController } from './picks/picks.controller';
import { PicksService } from './picks/picks.service';
import { ScheduleService } from './schedule/schedule.service';

/** The booking engine: schedule → hold → pay → confirm → live line → cancel/refund. Shared by app, admin and worker. */
@Global()
@Module({
  providers: [ScheduleService, PicksService, PaymentsService, BookingsService, LiveService],
  exports: [ScheduleService, PicksService, PaymentsService, BookingsService, LiveService],
})
export class CoreModule {}

/** HTTP + WebSocket side of the engine (API process only). */
@Module({
  controllers: [BookingsController, PaymentsController, LiveController, PicksController, AdminPicksController],
  providers: [LiveGateway],
})
export class CoreHttpModule {}
