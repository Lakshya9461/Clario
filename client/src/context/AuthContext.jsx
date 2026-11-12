import { createContext, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../auth.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    setUser(auth.me());
    setLoading(false);
  }, []);

  async function login(credentials) {
    setLoading(true);
    try {
      const { user: loggedIn } = await auth.login(credentials);
      setUser(loggedIn);
      navigate("/topics", { replace: true });
    } finally {
      setLoading(false);
    }
  }

  async function register(data) {
    setLoading(true);
    try {
      const { user: registered } = await auth.register(data);
      setUser(registered);
      navigate("/topics", { replace: true });
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    setLoading(true);
    try {
      await auth.logout();
      setUser(null);
      auth.clearSession();
      navigate("/login", { replace: true });
    } finally {
      setLoading(false);
    }
  }

  const value = {
    user,
    login,
    register,
    logout,
    loading,
    isAuthenticated: !!user,
    isAdmin: user && user.role === "admin",
  };

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
