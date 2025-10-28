import { Injectable, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { CreateUserDto } from '../dtos/create-user.dto';
import { UserRepository } from '../repositories/user.repository';

@Injectable()
export class UsersService {
  private repoWrapper: UserRepository;

  constructor(private repo: Repository<User>) {
    this.repoWrapper = new UserRepository(this.repo);
  }

  async create(createUserDto: CreateUserDto) {
    // validations
    const existingUser = await this.repoWrapper.findByUsername(
      createUserDto.username,
    );
    if (existingUser) throw new BadRequestException('Username already taken');

    const existingPhone = await this.repoWrapper.findByPhone(
      createUserDto.phoneNumber,
    );
    if (existingPhone)
      throw new BadRequestException('Phone number already used');

    const user = await this.repoWrapper.createAndSave({
      username: createUserDto.username,
      phoneNumber: createUserDto.phoneNumber,
    });

    return user;
  }

  async findByUuid(id: number) {
    return this.repoWrapper.findById(id);
  }
}
