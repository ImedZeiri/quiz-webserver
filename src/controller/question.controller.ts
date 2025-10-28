import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete
} from '@nestjs/common';
import { QuestionService } from '../service/question.service';
import { CreateQuestionDto } from '../dto/create-question.dto';
import { UpdateQuestionDto } from '../dto/update-question.dto';

@Controller('questions')
export class QuestionController {
  constructor(private readonly questionService: QuestionService) {}

  @Post()
  create(@Body() createQuestionDto: CreateQuestionDto) {
    return this.questionService.create(createQuestionDto);
  }

  @Get()
  async findAll() {
    const questions = await this.questionService.findAll();
    return questions;
  }

  @Get('api')
  findAllApi() {
    return this.questionService.findAll();
  }

  @Get('random/:limit')
  findRandom(@Param('limit') limit: string) {
    return this.questionService.findRandomQuestions(parseInt(limit));
  }

  @Get('theme/:theme')
  findByTheme(@Param('theme') theme: string) {
    return this.questionService.findByTheme(theme);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.questionService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateQuestionDto: UpdateQuestionDto) {
    return this.questionService.update(id, updateQuestionDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.questionService.remove(id);
  }
}
