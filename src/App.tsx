/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { NeonDriftGame } from './components/NeonDriftGame';
import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';

export default function App() {
  const [lastScore, setLastScore] = useState<number | null>(null);

  return (
    <div className="w-full h-screen bg-[#050505] overflow-hidden">
      <NeonDriftGame 
        onGameOver={(score) => {
          setLastScore(score);
        }}
        onStart={() => {
          setLastScore(null);
        }}
      />
      
      {/* Optional: Add a screen-shake or flash effect container here if needed */}
      <AnimatePresence>
        {lastScore !== null && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 pointer-events-none bg-red-500/10 flex items-center justify-center"
          >
            {/* Flash effect overlay */}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
