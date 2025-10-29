import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from './users.service';
import { RegisterDto } from '../dto/register.dto';
import * as crypto from 'crypto';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import axios from 'axios';

@Injectable()
export class AuthService {
  private otpStore: Map<string, { otp: string; expires: number }> = new Map();
  private readonly WIN_SMS_API_KEY =
    'LUJcxP5QOgROqZKt8ktFxan6eqcj0u2750HLM8lHrgEo2f4GjcZih5U3FOdR';
  private readonly WIN_SMS_SENDER = 'QUIZTN';
  private readonly WIN_SMS_API_URL = 'https://www.winsmspro.com/sms/sms/api';
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    const user = await this.usersService.create(registerDto);

    const payload = { sub: user.id, username: user.username };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user,
    };
  }

  // exemple utile pour guarded routes
  async validateUserById(userId: string) {
    return this.usersService.findById(userId);
  }
  generateOtp(phone: string): string {
    const otp = crypto.randomInt(1000, 9999).toString();
    const expires = Date.now() + 5 * 60 * 1000;
    this.otpStore.set(phone, { otp, expires });
    console.log('OTP stored for phone:', phone, {
      otp,
      expires: new Date(expires).toISOString(),
      currentTime: new Date().toISOString(),
    });
    console.log('Current OTP store:', Array.from(this.otpStore.entries()));
    return otp;
  }

  async sendOtp(phone: string): Promise<void> {
    console.log('sendOtp called with phone:', phone);
    let formattedPhone: string;
    try {
      const phoneNumber = parsePhoneNumberWithError(phone, 'TN');
      if (!phoneNumber.isValid()) {
        throw new Error('Invalid phone number');
      }
      // Use national number without adding 216 prefix (it's already included in nationalNumber)
      formattedPhone = phoneNumber.nationalNumber.toString();
      console.log('Formatted phone:', formattedPhone);
    } catch (error) {
      console.error('Phone number parsing error:', error);
      throw new BadRequestException(
        'Invalid phone number format. Use +216 followed by 8 digits.',
      );
    }

    const otp = this.generateOtp(formattedPhone);
    const message = `${otp}. Valid for 5 minutes.`;

    try {
      console.log('Sending SMS with WinSMS API');
      const response = await axios.get(this.WIN_SMS_API_URL, {
        params: {
          action: 'send-sms',
          api_key: this.WIN_SMS_API_KEY,
          to: `216${formattedPhone}`, // Add 216 prefix for Tunisia
          from: this.WIN_SMS_SENDER,
          sms: message,
        },
      });

      console.log('WinSMS API response:', response.data);

      if (response.data?.code !== 'ok') {
        throw new Error(response.data?.message || 'Failed to send SMS');
      }

      console.log('SMS sent successfully');
      return; // Explicit return to ensure we don't throw an error on success
    } catch (error) {
      console.error('WinSMS API error:', error.response?.data || error.message);
      throw new BadRequestException(`Failed to send OTP: ${error.message}`);
    }
  }

  verifyOtp(phone: string, otp: string): boolean {
    console.log('verifyOtp called with phone:', phone, 'otp:', otp);
    let formattedPhone: string;
    try {
      const phoneNumber = parsePhoneNumberWithError(phone, 'TN');
      // Format the phone number consistently with how it's stored
      formattedPhone = phoneNumber.nationalNumber.toString();
      console.log('Formatted phone for verification:', formattedPhone);
    } catch (error) {
      console.error('Phone number parsing error in verifyOtp:', error);
      return false;
    }

    console.log(
      ' Current OTP store before verification:',
      Array.from(this.otpStore.entries()),
    );
    const stored = this.otpStore.get(formattedPhone);

    if (!stored) {
      console.log('No OTP found for phone:', formattedPhone);
      return false;
    }

    if (Date.now() > stored.expires) {
      console.log('OTP expired:', {
        currentTime: new Date().toISOString(),
        expiresAt: new Date(stored.expires).toISOString(),
      });
      this.otpStore.delete(formattedPhone);
      return false;
    }

    if (stored.otp !== otp) {
      console.log('OTP mismatch:', { storedOTP: stored.otp, providedOTP: otp });
      return false;
    }

    console.log('OTP verified successfully for:', formattedPhone);
    this.otpStore.delete(formattedPhone);
    return true;
  }
}
