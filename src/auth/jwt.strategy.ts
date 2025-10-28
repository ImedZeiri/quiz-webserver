import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../services/auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || '123456',
    });
  }

  async validate(payload: any) {
    // payload.sub contient l'id
    const user = await this.authService.validateUserById(payload.sub);
    if (!user) return null;
    // on peut renvoyer l'utilisateur attaché à req.user
    return { id: user.id, username: user.username };
  }
}
