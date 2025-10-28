import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateQuestionDto } from '../dtos/create-question.dto';
import { UpdateQuestionDto } from '../dtos/update-question.dto';
import { Question } from '../entities/question.entity';

@Injectable()
export class QuestionService {
  constructor(
    @InjectRepository(Question)
    private readonly questionRepository: Repository<Question>,
  ) {}

  async create(createQuestionDto: CreateQuestionDto): Promise<Question> {
    const question = this.questionRepository.create(createQuestionDto);
    return this.questionRepository.save(question);
  }

  async findAll(): Promise<Question[]> {
    return this.questionRepository.find();
  }

  async findOne(id: number): Promise<Question | null> {
    return this.questionRepository.findOne({ where: { id } });
  }

  async update(id: number, updateQuestionDto: UpdateQuestionDto): Promise<Question | null> {
    await this.questionRepository.update(id, updateQuestionDto);
    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    await this.questionRepository.delete(id);
  }

  async findRandomQuestions(limit: number = 10): Promise<Question[]> {
    return this.questionRepository
      .createQueryBuilder('question')
      .orderBy('RAND()')
      .limit(limit)
      .getMany();
  }

  async findByTheme(theme: string): Promise<Question[]> {
    return this.questionRepository.find({ where: { theme } });
  }
}
