import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class Event extends Document {
  @Prop({ required: true })
  theme: string;

  @Prop({ required: true })
  startDate: Date;

  @Prop({ required: true })
  numberOfQuestions: number;

  @Prop()
  winner?: string;

  @Prop({ default: false })
  isCompleted: boolean;

  @Prop({ default: 2 })
  minPlayers: number;

  @Prop({ default: false })
  lobbyOpen: boolean;

  @Prop({ default: false })
  isStarted: boolean;
}

export const EventSchema = SchemaFactory.createForClass(Event);

// Hook pour détecter les changements automatiquement
EventSchema.post('findOneAndUpdate', function(doc) {
  if (doc && global.gatewayService) {
    global.gatewayService.handleEventUpdated(doc);
  }
});

EventSchema.post('save', function(doc) {
  if (doc && global.gatewayService) {
    global.gatewayService.handleEventUpdated(doc);
  }
});

EventSchema.post('findOneAndDelete', function(doc) {
  if (doc && global.gatewayService) {
    global.gatewayService.handleEventDeleted(doc.id);
  }
});