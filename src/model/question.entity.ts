import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('question')
export class Question {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  theme: string;

  @Column({ type: 'text' })
  questionText: string;

  @Column()
  response1: string;

  @Column()
  response2: string;

  @Column()
  response3: string;

  @Column()
  response4: string;

  @Column()
  correctResponse: number;
}
