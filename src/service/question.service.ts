import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateQuestionDto } from '../dto/create-question.dto';
import { UpdateQuestionDto } from '../dto/update-question.dto';
import { Question } from '../model/question.entity';

@Injectable()
export class QuestionService {
  constructor(
    @InjectModel(Question.name)
    private readonly questionModel: Model<Question>,
  ) {}

  async create(createQuestionDto: CreateQuestionDto): Promise<Question> {
    const question = new this.questionModel(createQuestionDto);
    return question.save();
  }

  async findAll(): Promise<Question[]> {
    return this.questionModel.find().exec();
  }

  async findOne(id: string): Promise<Question | null> {
    return this.questionModel.findById(id).exec();
  }

  async update(id: string, updateQuestionDto: UpdateQuestionDto): Promise<Question | null> {
    return this.questionModel.findByIdAndUpdate(id, updateQuestionDto, { new: true }).exec();
  }

  async remove(id: string): Promise<void> {
    await this.questionModel.findByIdAndDelete(id).exec();
  }

  async findRandomQuestions(limit: number = 10): Promise<Question[]> {
    return this.questionModel.aggregate([
      { $sample: { size: limit } }
    ]).exec();
  }

  async findByTheme(theme: string): Promise<Question[]> {
    if (!theme || theme.trim() === '') {
      return [];
    }
    return this.questionModel.find({ theme }).exec();
  }
}