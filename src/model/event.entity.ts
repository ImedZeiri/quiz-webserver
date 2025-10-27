import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('event')
export class Event {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  theme: string;

  @Column({ type: 'datetime' })
  startDate: Date;

  @Column()
  numberOfQuestions: number;

  @Column({ nullable: true })
  winner?: string;

  @Column({ default: false })
  isCompleted: boolean;
}