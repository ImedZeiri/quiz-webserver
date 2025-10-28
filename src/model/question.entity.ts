import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class Question extends Document {
  @Prop({ required: true })
  theme: string;

  @Prop({ required: true })
  questionText: string;

  @Prop({ required: true })
  response1: string;

  @Prop({ required: true })
  response2: string;

  @Prop({ required: true })
  response3: string;

  @Prop({ required: true })
  response4: string;

  @Prop({ required: true })
  correctResponse: number;
}

export const QuestionSchema = SchemaFactory.createForClass(Question);
