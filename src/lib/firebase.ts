import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// These will be injected by the environment if configured
const firebaseConfig = {
  apiKey: "placeholder",
  authDomain: "placeholder",
  projectId: "gen-lang-client-0319047392",
  storageBucket: "placeholder",
  messagingSenderId: "placeholder",
  appId: "placeholder"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
