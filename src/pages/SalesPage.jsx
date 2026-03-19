import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const LS_KEY = 'sales_last_person';

export default function SalesPage() {
  const navigate = useNavigate();
  const person = localStorage.getItem(LS_KEY);

  useEffect(() => {
    if (person) {
      navigate('/sales/my', { replace: true });
    } else {
      navigate('/sales/login', { replace: true });
    }
  }, [person, navigate]);

  return null;
}
