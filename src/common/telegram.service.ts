import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class TelegramService {
  private readonly BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  private readonly CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  async sendMessage(text: string) {
    const url = `https://api.telegram.org/bot${this.BOT_TOKEN}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: this.CHAT_ID,
        text,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      console.error(
        '❌ Telegram 전송 실패:',
        err.response?.data || err.message,
      );
    }
  }
}
