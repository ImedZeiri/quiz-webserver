import { Injectable } from '@nestjs/common';
import { CreateQuestionDto } from '../dto/create-question.dto';
import { UpdateQuestionDto } from '../dto/update-question.dto';
import { Question } from '../model/question.entity';
import { QuestionRepository } from '../repository/question.repository';

@Injectable()
export class QuestionService {
  constructor(
    private readonly questionRepository: QuestionRepository,
  ) {}

  async create(createQuestionDto: CreateQuestionDto): Promise<Question> {
    return this.questionRepository.create(createQuestionDto);
  }

  async findAll(): Promise<Question[]> {
    return this.questionRepository.findAll();
  }

  async findOne(id: string): Promise<Question | null> {
    return this.questionRepository.findById(id);
  }

  async update(id: string, updateQuestionDto: UpdateQuestionDto): Promise<Question | null> {
    return this.questionRepository.update(id, updateQuestionDto);
  }

  async remove(id: string): Promise<Question | null> {
    return this.questionRepository.delete(id);
  }

  async findRandomQuestions(limit: number = 10): Promise<Question[]> {
    return this.questionRepository.findRandomQuestions(limit);
  }

  async findByTheme(theme: string): Promise<Question[]> {
    return this.questionRepository.findByTheme(theme);
  }
}
