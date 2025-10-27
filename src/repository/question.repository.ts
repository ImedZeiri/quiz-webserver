import { DataSource, Repository } from 'typeorm';
import { Question } from '../model/question.entity';
import { Injectable } from '@nestjs/common';

@Injectable()
export class QuestionRepository extends Repository<Question> {
  constructor(private dataSource: DataSource) {
    super(Question, dataSource.createEntityManager());
  }

  async findRandomQuestions(limit: number): Promise<Question[]> {
    return this.createQueryBuilder('question')
      .orderBy('RAND()')
      .limit(limit)
      .getMany();
  }

  async findByTheme(theme: string): Promise<Question[]> {
    return this.find({ where: { theme } });
  }
}
