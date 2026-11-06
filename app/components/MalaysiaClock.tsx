'use client';

import { useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';
import './malaysia-clock.css';

const malaysiaTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export default function MalaysiaClock({ label }: { label: string }) {
  const [time, setTime] = useState('');

  useEffect(() => {
    const update = () => setTime(malaysiaTime.format(new Date()));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="malaysia-clock">
      <Clock3 size={15} aria-hidden="true" />
      <span className="malaysia-clock-label">{label}</span>
      <time dateTime={time || undefined}>{time || '--:--:--'}</time>
    </div>
  );
}
