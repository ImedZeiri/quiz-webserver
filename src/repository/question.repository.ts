import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Question } from '../model/question.entity';

@Injectable()
export class QuestionRepository {
  constructor(
    @InjectModel(Question.name) private questionModel: Model<Question>,
  ) {}

  async create(questionData: Partial<Question>): Promise<Question> {
    const question = new this.questionModel(questionData);
    return question.save();
  }

  async findAll(): Promise<Question[]> {
    return this.questionModel.find().exec();
  }

  async findById(id: string): Promise<Question | null> {
    return this.questionModel.findById(id).exec();
  }

  async findRandomQuestions(limit: number): Promise<Question[]> {
    return this.questionModel.aggregate([
      { $sample: { size: limit } }
    ]);
  }

  async findByTheme(theme: string): Promise<Question[]> {
    return this.questionModel.find({ theme }).exec();
  }

  async update(id: string, updateData: Partial<Question>): Promise<Question | null> {
    return this.questionModel.findByIdAndUpdate(id, updateData, { new: true }).exec();
  }

  async delete(id: string): Promise<Question | null> {
    return this.questionModel.findByIdAndDelete(id).exec();
  }
}
