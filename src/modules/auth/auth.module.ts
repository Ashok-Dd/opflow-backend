import { Global, Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordsService } from './passwords.service';
import { TokensService } from './tokens.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, TokensService, PasswordsService],
  exports: [AuthService, TokensService, PasswordsService],
})
export class AuthModule {}
