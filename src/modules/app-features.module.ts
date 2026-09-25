import { Global, Module } from '@nestjs/common';

import { DoctorController } from './doctor/doctor.controller';
import { DoctorService } from './doctor/doctor.service';
import { EmergencyController } from './emergency/emergency.controller';
import { MeController } from './me/me.controller';

@Global()
@Module({ providers: [DoctorService], exports: [DoctorService] })
export class DoctorCoreModule {}

/** Patient and doctor app endpoints (API process only). */
@Module({ controllers: [MeController, DoctorController, EmergencyController] })
export class AppFeaturesModule {}
