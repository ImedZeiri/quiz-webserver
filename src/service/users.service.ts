import { Injectable, BadRequestException } from '@nestjs/common';
import { User } from '../model/user.entity';
import { CreateUserDto } from '../dto/create-user.dto';
import { UserRepository } from '../repository/user.repository';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Injectable()
export class UsersService {
  private repoWrapper: UserRepository;

  constructor(private readonly userRepository: UserRepository) {}

  async create(createUserDto: CreateUserDto) {
    // validations
    // const existingPhone = await this.repoWrapper.findByPhone(
    //   createUserDto.phoneNumber,
    // );
    // if (existingPhone)
    //   throw new BadRequestException('Phone number already used');

    const user = await this.userRepository.createAndSave({
      username: createUserDto.username,
      phoneNumber: createUserDto.phoneNumber,
    });

    return user;
  }

  async findByUuid(id: string) {
    return this.userRepository.findById(id);
  }
}
