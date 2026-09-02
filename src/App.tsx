/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import VoiceAssistant from './components/VoiceAssistant';
import TrackComplaints from './components/TrackComplaints';
import { IVRDialer } from './components/IVRDialer';
import Admin from './components/Admin';
import { Mic, FileText, Lock, User, Bell, X, Check, Upload, PhoneCall } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';
import { UserProfile } from './types';

function FloatingProfileButton({ onProfileClick, profile }: { onProfileClick: () => void; profile: UserProfile }) {
  const location = useLocation();
  if (location.pathname.startsWith('/admin')) {
    return null;
  }
  return (
    <button 
      onClick={onProfileClick}
      className="fixed top-4 right-4 z-50 w-11 h-11 rounded-full bg-white/95 hover:bg-white text-rose-600 shadow-xl border border-white/70 flex items-center justify-center font-black transition-all hover:scale-105 active:scale-95 cursor-pointer backdrop-blur-md"
      title="User Profile"
    >
      {profile.name ? (
        <span className="text-sm font-black">{profile.name.charAt(0).toUpperCase()}</span>
      ) : (
        <User size={18} className="text-rose-600" />
      )}
    </button>
  );
}

function MobileNav() {
  const location = useLocation();

  // Hide bottom footer and customer options when inside Admin routes
  if (location.pathname.startsWith('/admin')) {
    return null;
  }

  const links = [
    { to: '/', label: 'Talk', icon: Mic },
    { to: '/ivr', label: 'IVR Demo', icon: PhoneCall },
    { to: '/track', label: 'Track Reports', icon: FileText },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 bg-white/10 backdrop-blur-2xl border-t border-white/20 z-50 px-6 flex items-center justify-around shadow-[0_-8px_32px_rgba(0,0,0,0.15)]">
      {links.map(({ to, label, icon: Icon }) => {
        const isActive = location.pathname === to;
        return (
          <Link 
            key={to} 
            to={to} 
            className="relative flex flex-col items-center gap-0.5 min-w-[72px]"
          >
            <div className={`p-2 rounded-2xl transition-all duration-300 ${
              isActive
              ? 'bg-white text-rose-600 shadow-xl shadow-black/15 -translate-y-1 scale-105 backdrop-blur-md' 
              : 'text-white/70 hover:text-white hover:bg-white/10'
            }`}>
              <Icon size={19} />
            </div>
            <span className={`text-[10px] font-bold uppercase tracking-wider transition-all whitespace-nowrap ${
              isActive ? 'text-white font-black opacity-100 drop-shadow-sm' : 'text-white/65 opacity-80'
            }`}>
              {label}
            </span>
            {isActive && (
              <motion.div 
                layoutId="nav-dot"
                className="absolute -top-1 w-1.5 h-1.5 bg-white rounded-full shadow-[0_0_8px_rgba(255,255,255,0.9)]"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function ProfileModal({ isOpen, onClose, profile, setProfile }: { 
  isOpen: boolean; 
  onClose: () => void; 
  profile: UserProfile;
  setProfile: (p: UserProfile) => void;
}) {
  const [tempProfile, setTempProfile] = useState(profile);

  const handleSave = () => {
    setProfile(tempProfile);
    localStorage.setItem('vox_profile', JSON.stringify(tempProfile));
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-6">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div 
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 relative shadow-2xl"
          >
            <div className="text-center mb-8">
              <div className="relative w-24 h-24 mx-auto mb-4 group cursor-pointer" onClick={() => document.getElementById('photo-upload')?.click()}>
                <div className="w-full h-full bg-indigo-50 rounded-[2rem] flex items-center justify-center text-indigo-600 overflow-hidden border-4 border-white shadow-lg">
                  {tempProfile.photoUrl ? (
                    <img src={tempProfile.photoUrl} alt="Profile" className="w-full h-full object-cover" />
                  ) : (
                    <User size={40} />
                  )}
                </div>
                <div className="absolute inset-0 bg-indigo-600/20 opacity-0 group-hover:opacity-100 transition-opacity rounded-[2rem] flex items-center justify-center text-white">
                  <Upload size={20} />
                </div>
                <input 
                  id="photo-upload"
                  type="file" 
                  className="hidden" 
                  accept="image/*"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const formData = new FormData();
                      formData.append('file', file);
                      const res = await fetch('/api/upload', { method: 'POST', body: formData });
                      const data = await res.json();
                      setTempProfile({ ...tempProfile, photoUrl: data.url });
                    }
                  }}
                />
              </div>
              <h2 className="text-xl font-bold">User Identity</h2>
              <p className="text-sm text-slate-400">Manage your profile details</p>
            </div>

            <div className="space-y-4 mb-8 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Full Name</label>
                <input 
                  value={tempProfile.name}
                  onChange={(e) => setTempProfile({ ...tempProfile, name: e.target.value })}
                  placeholder="Enter name"
                  className="w-full bg-slate-50 p-4 rounded-2xl outline-none focus:ring-2 ring-indigo-100 transition-all border border-transparent focus:border-indigo-200 font-medium"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Phone</label>
                <input 
                  value={tempProfile.phone}
                  onChange={(e) => setTempProfile({ ...tempProfile, phone: e.target.value })}
                  placeholder="Enter phone"
                  className="w-full bg-slate-50 p-4 rounded-2xl outline-none focus:ring-2 ring-indigo-100 transition-all border border-transparent focus:border-indigo-200 font-medium"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Location (Optional)</label>
                <input 
                  value={tempProfile.location || ''}
                  onChange={(e) => setTempProfile({ ...tempProfile, location: e.target.value })}
                  placeholder="Enter city/area"
                  className="w-full bg-slate-50 p-4 rounded-2xl outline-none focus:ring-2 ring-indigo-100 transition-all border border-transparent focus:border-indigo-200 font-medium"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={onClose}
                className="py-4 rounded-2xl font-bold text-slate-400 hover:bg-slate-50 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleSave}
                className="bg-indigo-600 text-white py-4 rounded-2xl font-bold shadow-xl shadow-indigo-100 hover:bg-indigo-700 active:scale-95 transition-all flex items-center justify-center gap-2"
              >
                <Check size={18} /> Save
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export default function App() {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [profile, setProfile] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('vox_profile');
    return saved ? JSON.parse(saved) : { name: '', phone: '' };
  });

  return (
    <BrowserRouter>
      <div className="min-h-screen bg-pepero-gradient text-slate-900 font-sans selection:bg-white/30 selection:text-white relative">
        <FloatingProfileButton onProfileClick={() => setIsProfileOpen(true)} profile={profile} />
        <main className="pt-4 pb-20">
          <AnimatePresence mode="wait">
            <Routes>
              <Route path="/" element={<VoiceAssistant profile={profile} />} />
              <Route path="/ivr" element={<IVRDialer profile={profile} />} />
              <Route path="/track" element={<TrackComplaints profile={profile} onOpenProfile={() => setIsProfileOpen(true)} />} />
              <Route path="/admin/*" element={<Admin />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </AnimatePresence>
        </main>
        <MobileNav />
        <ProfileModal 
          isOpen={isProfileOpen} 
          onClose={() => setIsProfileOpen(false)} 
          profile={profile}
          setProfile={setProfile}
        />
      </div>
    </BrowserRouter>
  );
}

