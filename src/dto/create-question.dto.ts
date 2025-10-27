import { IsString, IsNumber, IsNotEmpty, Min, Max } from 'class-validator';

export class CreateQuestionDto {
  @IsString()
  @IsNotEmpty()
  theme: string;

  @IsString()
  @IsNotEmpty()
  questionText: string;

  @IsString()
  @IsNotEmpty()
  response1: string;

  @IsString()
  @IsNotEmpty()
  response2: string;

  @IsString()
  @IsNotEmpty()
  response3: string;

  @IsString()
  @IsNotEmpty()
  response4: string;

  @IsNumber()
  @Min(1)
  @Max(4)
  correctResponse: number;
}
