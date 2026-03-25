import {
  useState,
  useEffect,
  useCallback,
  createContext,
  useContext,
} from "react";

const ToastContext = createContext(null);

let _showToast = () => {};

export function useToast() {
  return useContext(ToastContext) || _showToast;
}

/** Call from anywhere: showToast('msg') or showToast('msg', true) for error */
export function showToast(msg, isErr = false) {
  _showToast(msg, isErr);
}

export default function Toast() {
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const show = useCallback((msg, err = false) => {
    setMessage(msg);
    setIsError(err);
    setVisible(true);
  }, []);

  useEffect(() => {
    _showToast = show;
  }, [show]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 3500);
    return () => clearTimeout(timer);
  }, [visible, message]);

  return (
    <div className={`toast${visible ? " show" : ""}${isError ? " err" : ""}`}>
      {message}
    </div>
  );
}
