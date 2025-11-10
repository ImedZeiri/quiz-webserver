import {
  BadRequestException,
  Controller,
  Post,
  Body,
  UnauthorizedException,
  Res,
  Req,
} from '@nestjs/common';

import type { Response, Request } from 'express';
import { AuthService } from '../service/auth.service';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from '../dto/register.dto';
import { VerifyOtpDto } from '../dto/verify-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
  ) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    await this.authService.sendOtp(registerDto.phoneNumber);
    return { success: true, message: 'OTP sent successfully' };
  }

  /**
   * ✅ Étape 2 : Vérifier OTP, créer utilisateur et set cookie
   */
  /**
   * ✅ Étape 1 : Vérifier l'OTP et créer les tokens
   */
  @Post('verify-otp')
  async verifyOtp(@Body() verifyOtpDto: VerifyOtpDto, @Res({ passthrough: true }) res: Response) {
    // Vérification OTP
    const isValid = await this.authService.verifyOtp(
      verifyOtpDto.phoneNumber,
      verifyOtpDto.otp,
    );
    if (!isValid) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    // Création / récupération du user
    const player = await this.authService.register({
      phoneNumber: verifyOtpDto.phoneNumber,
      username: verifyOtpDto.username ?? `user_${Date.now()}`,
    });

    // Payload du token
    const payload = {
      sub: String(player.user._id),
      phoneNumber: player.user.phoneNumber,
      username: player.user.username,
      role: 'user',
    };

    // Génération des tokens
    const accessToken = this.jwtService.sign(payload, { expiresIn: '300y' }); // 1 minute pour test
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '301y' }); // 7 jours

    // Sauvegarde du refreshToken (haché en mémoire ou BDD)
    await this.authService.saveRefreshToken(player.user._id, refreshToken);

    // Envoi du refresh token dans un cookie sécurisé
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: true, // true seulement en HTTPS
      sameSite: 'none',
      path: '/', //  pas besoin de limiter à /auth/refresh, sinon il ne sera pas envoyé ailleurs
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
    });
    // res.cookie('refresh_token', refreshToken, {
    //   httpOnly: true,
    //   secure: false, // ⚠️ mettre false en local sinon Chrome le bloque
    //   sameSite: 'lax', // 'lax' = bon équilibre pour les tests
    //   path: '/', // pour qu’il soit envoyé sur /auth/refresh
    //   maxAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
    // });

    // Retourne seulement le token d'accès
    return res.json({
      success: true,
      player: {
        id: player.user._id,
        username: player.user.username,
        phoneNumber: player.user.phoneNumber,
        score: player.user.score ?? 0,
      },
      accessToken,
    });
  }

  /**
   * ✅ Étape 3 : Refresh via cookie
   */
  /**
   * ✅ Étape 2 : Rafraîchir l'access token via le cookie
   */
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.['refresh_token'];
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token found');
    }

    try {
      // Vérifier le refresh token JWT
      const decoded = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_SECRET || '123456',
      });

      // Vérifier qu’il correspond bien à celui enregistré pour cet utilisateur
      const isValid = await this.authService.validateRefreshToken(decoded.sub, refreshToken);
      if (!isValid) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Générer un nouveau accessToken
      const newAccessToken = this.jwtService.sign(
        {
          sub: decoded.sub,
          username: decoded.username,
          phoneNumber: decoded.phoneNumber,
          role: decoded.role,
        },
        { expiresIn: '300y' },
      );

      // Optionnel : Regénérer un nouveau refresh token (rotation)
      const newRefreshToken = this.jwtService.sign(
        {
          sub: decoded.sub,
          username: decoded.username,
          phoneNumber: decoded.phoneNumber,
          role: decoded.role,
        },
        { expiresIn: '7d' },
      );

      await this.authService.saveRefreshToken(decoded.sub, newRefreshToken);

      // Met à jour le cookie
      res.cookie('refresh_token', newRefreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      // res.cookie('refresh_token', newRefreshToken, {
      //   httpOnly: true,
      //   secure: false, // ⚠️ pour local (mettre true en prod HTTPS)
      //   sameSite: 'lax', // pour les tests, éviter 'strict'
      //   path: '/',
      //   maxAge: 7 * 24 * 60 * 60 * 1000,
      // });

      return res.json({ accessToken: newAccessToken });
    } catch (error) {
      console.error('[AuthController] Refresh failed:', error);
      throw new UnauthorizedException('Refresh token expired or invalid');
    }
  }
}
