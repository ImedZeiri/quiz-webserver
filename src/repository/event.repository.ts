import { Repository } from 'typeorm';
import { Event } from '../model/event.entity';

export class EventRepository extends Repository<Event> {
  async findActiveEvents(): Promise<Event[]> {
    return this.find({
      where: { isCompleted: false },
      order: { startDate: 'ASC' }
    });
  }

  async findByTheme(theme: string): Promise<Event[]> {
    return this.find({ where: { theme } });
  }
}