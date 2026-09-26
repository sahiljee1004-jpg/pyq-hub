import { initializeApp } from
"https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

import {
    getAuth,
    GoogleAuthProvider
} from
"https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    getFirestore
} from
"https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


const firebaseConfig = {

    apiKey: "AIzaSyAvfpkFk0E8KecRHkJd2HD1RL2P4reiuNo",
  authDomain:  "pyqs-hub-43bed.firebaseapp.com",
  projectId: "pyqs-hub-43bed",
  storageBucket:  "pyqs-hub-43bed.firebasestorage.app",
  messagingSenderId: "766070215379",
  appId:  "1:766070215379:web:9a7aa7ec2c924039423a26",

};


const app =
    initializeApp(firebaseConfig);


export const auth =
    getAuth(app);


export const db =
    getFirestore(app);


export const googleProvider =
    new GoogleAuthProvider();