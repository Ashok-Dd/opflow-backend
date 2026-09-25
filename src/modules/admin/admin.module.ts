import { Global, Module } from '@nestjs/common';

import { AdminAuthController, AdminDoctorsController, AdminHomeController, AdminOpsController } from './admin.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminDoctorsService } from './admin-doctors.service';
import { AdminService } from './admin.service';
import { ChangesService } from './changes.service';

/** Services shared with the admin:create command. */
@Global()
@Module({
  providers: [AdminAuthService, ChangesService, AdminDoctorsService, AdminService],
  exports: [AdminAuthService, ChangesService, AdminDoctorsService, AdminService],
})
export class AdminCoreModule {}

/** /v1/admin/* — admin-site sessions only (aud: admin), never app tokens. */
@Module({ controllers: [AdminAuthController, AdminHomeController, AdminDoctorsController, AdminOpsController] })
export class AdminModule {}
