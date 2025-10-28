import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventRepository {
  constructor(
    @InjectModel(Event.name) private eventModel: Model<Event>,
  ) {}

  async create(eventData: Partial<Event>): Promise<Event> {
    const event = new this.eventModel(eventData);
    return event.save();
  }

  async findAll(): Promise<Event[]> {
    return this.eventModel.find().exec();
  }

  async findById(id: string): Promise<Event | null> {
    return this.eventModel.findById(id).exec();
  }

  async findActiveEvents(): Promise<Event[]> {
    return this.eventModel
      .find({ isCompleted: false })
      .sort({ startDate: 1 })
      .exec();
  }

  async findByTheme(theme: string): Promise<Event[]> {
    return this.eventModel.find({ theme }).exec();
  }

  async update(id: string, updateData: Partial<Event>): Promise<Event | null> {
    return this.eventModel.findByIdAndUpdate(id, updateData, { new: true }).exec();
  }

  async delete(id: string): Promise<Event | null> {
    return this.eventModel.findByIdAndDelete(id).exec();
  }
}