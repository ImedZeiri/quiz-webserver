import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QuestionRepository } from '../repository/question.repository';
import { CreateQuestionDto } from '../dto/create-question.dto';
import { UpdateQuestionDto } from '../dto/update-question.dto';
import { Question } from '../model/question.entity';

@Injectable()
export class QuestionService {
  constructor(
    @InjectRepository(QuestionRepository)
    private readonly questionRepository: QuestionRepository,
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
    return this.questionRepository.findRandomQuestions(limit);
  }

  async findByTheme(theme: string): Promise<Question[]> {
    return this.questionRepository.findByTheme(theme);
  }
}
