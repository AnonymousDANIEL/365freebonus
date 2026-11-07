'use client';

import { useEffect, useState } from 'react';
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
    <div className="malaysia-clock" role="group" aria-label={label}>
      <svg className="malaysia-flag" viewBox="0 0 56 28" aria-hidden="true" focusable="false">
        <path fill="#cc142b" d="M0 0h56v28H0z" />
        <path fill="#fff" d="M0 2h56v2H0zM0 6h56v2H0zM0 10h56v2H0zM0 14h56v2H0zM0 18h56v2H0zM0 22h56v2H0zM0 26h56v2H0z" />
        <path fill="#001a70" d="M0 0h28v16H0z" />
        <circle fill="#ffce00" cx="8.5" cy="8" r="5.8" />
        <circle fill="#001a70" cx="10.5" cy="8" r="5.1" />
        <polygon fill="#ffce00" points="21.00,2.40 21.51,5.76 23.43,2.95 22.43,6.20 25.38,4.51 23.07,7.00 26.46,6.75 23.30,8.00 26.46,9.25 23.07,9.00 25.38,11.49 22.43,9.80 23.43,13.05 21.51,10.24 21.00,13.60 20.49,10.24 18.57,13.05 19.57,9.80 16.62,11.49 18.93,9.00 15.54,9.25 18.70,8.00 15.54,6.75 18.93,7.00 16.62,4.51 19.57,6.20 18.57,2.95 20.49,5.76" />
      </svg>
      <time dateTime={time || undefined}>{time || '--:--:--'}</time>
    </div>
  );
}
