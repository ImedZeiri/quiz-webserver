import { Injectable } from '@nestjs/common';
import { CreateUserDto } from '../dto/create-user.dto';
import { UserRepository } from '../repository/user.repository';

@Injectable()
export class UsersService {
  constructor(private readonly userRepository: UserRepository) {}

  async create(createUserDto: CreateUserDto) {
    // Vérifier si un utilisateur existe déjà avec ce numéro de téléphone
    const existingUser = await this.userRepository.findByPhone(
      createUserDto.phoneNumber,
    );

    if (existingUser) {
      // Mettre à jour uniquement le username
      existingUser.username = createUserDto.username;
      await existingUser.save();

      return {
        ...existingUser.toObject(),
        message: 'Username updated for existing user',
      };
    }

    // Si aucun utilisateur n'existe, on en crée un nouveau
    const newUser = await this.userRepository.createAndSave({
      username: createUserDto.username,
      phoneNumber: createUserDto.phoneNumber,
    });

    return {
      ...newUser.toObject(),
      message: 'New user created successfully',
    };
  }

  async findById(id: string) {
    return this.userRepository.findById(id);
  }
}
