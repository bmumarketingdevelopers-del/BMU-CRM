import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { MeService } from './me.service.js';
import { OtpSender } from './otp-sender.js';
import { SESSION_TTL_SECONDS } from './session.js';
import { SecurityController } from './security.controller.js';
import { SessionsService } from './sessions.service.js';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET ?? 'dev-only-change-me',
        signOptions: { expiresIn: SESSION_TTL_SECONDS },
      }),
    }),
  ],
  controllers: [AuthController, SecurityController],
  providers: [AuthService, MeService, OtpSender, SessionsService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [MeService, SessionsService],
})
export class AuthModule {}
