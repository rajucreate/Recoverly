import { useCallback, useState } from 'react';

export function useApiState() {
  const [state, setState] = useState({ data: null, loading: false, error: null });

  const run = useCallback(async (operation) => {
    setState({ data: null, loading: true, error: null });
    try {
      const data = await operation();
      setState({ data, loading: false, error: null });
      return data;
    } catch (error) {
      setState({ data: null, loading: false, error });
      throw error;
    }
  }, []);

  return { ...state, run };
}
