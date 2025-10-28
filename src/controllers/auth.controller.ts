import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from '../dtos/register.dto';
import { VerifyOtpDto } from '../dtos/verify-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService, // ✅ injection manquante
  ) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    await this.authService.sendOtp(registerDto.phoneNumber);
    return {
      success: true,
      message: 'OTP sent successfully',
      phoneNumber: registerDto.phoneNumber,
    };
  }

  @Post('verify-otp')
  async verifyOtp(@Body() verifyOtpDto: VerifyOtpDto) {
    // 1- Vérifier l’OTP
    const isValid = this.authService.verifyOtp(
      verifyOtpDto.phoneNumber,
      verifyOtpDto.otp,
    );

    if (!isValid) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    // 2- Créer ou récupérer l’utilisateur
    const player = await this.authService.register({
      phoneNumber: verifyOtpDto.phoneNumber,
      username: verifyOtpDto.username ?? `user_${Date.now()}`,
    });

    // 3- Générer le JWT
    const payload = {
      sub: player.user.id,
      phoneNumber: player.user.phoneNumber,
      username: player.user.username,
      role: 'user',
    };

    const token = this.jwtService.sign(payload);

    // 4- Retour propre
    return {
      success: true,
      player: {
        id: player.user.id,
        phoneNumber: player.user.phoneNumber,
        username: player.user.username,
        score: player.user.score ?? 0,
      },
      token,
    };
  }
}
