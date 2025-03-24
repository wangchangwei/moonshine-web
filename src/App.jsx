import { useRef, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { motion } from "motion/react";
import { Howl } from 'howler';

import BloomScene from "./components/BloomScene";
import AnimatedMesh from "./components/AnimatedMesh";

import { SAMPLE_RATE } from "./constants";
import { formatDate } from "./utils";

function App() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [frequency, setFrequency] = useState(0);
  const [audioFile, setAudioFile] = useState(null);
  const [audioPlayer, setAudioPlayer] = useState(null);
  const [audioSource, setAudioSource] = useState('microphone');
  const [isPlaying, setIsPlaying] = useState(false);
  const worker = useRef(null);

  useEffect(() => {
    // Initialize worker on mount
    worker.current ??= new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });

    // NOTE: Certain browsers handle error messages differently, so to ensure
    // compatibility, we need to handle errors in both `message` and `error` events.
    const onMessage = ({ data }) => {
      if (data.error) {
        return onError(data.error);
      }
      if (data.type === "status") {
        // 将状态消息翻译为中文
        const statusMessages = {
          "loading": "正在加载模型...",
          "ready": "模型已就绪",
          "recording_start": "开始录音",
          "recording_stop": "停止录音"
        };
        const translatedMessage = statusMessages[data.message] || data.message;
        setStatus(data.message); // 保持原始状态值
        setMessages((prev) => [...prev, { ...data, message: translatedMessage }]);
      } else {
        setMessages((prev) => [...prev, data]);
      }
    };
    const onError = (error) => setError(error.message);

    // Attach the callback function as an event listener.
    worker.current.addEventListener("message", onMessage);
    worker.current.addEventListener("error", onError);

    // Define a cleanup function for when the component is unmounted.
    return () => {
      worker.current.removeEventListener("message", onMessage);
      worker.current.removeEventListener("error", onError);
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    let audioStream;
    let worklet;
    let audioContext;
    let source;

    const initializeMicrophone = async () => {
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true,
            sampleRate: SAMPLE_RATE,
          },
        });

        if (ignore) return;

        audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: SAMPLE_RATE,
          latencyHint: "interactive",
        });

        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 32;

        source = audioContext.createMediaStreamSource(audioStream);
        source.connect(analyser);

        setupAudioAnalysis(analyser);
        await setupWorklet(audioContext, source);
      } catch (err) {
        setError(err.message);
        console.error(err);
      }
    };

    if (audioSource === 'microphone') {
      initializeMicrophone();
    }

    return () => {
      ignore = true;
      if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
      }
      source?.disconnect();
      worklet?.disconnect();
      audioContext?.close();
    };
  }, [audioSource]);

  const setupAudioAnalysis = (analyser) => {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const getAverageFrequency = () => {
      analyser.getByteFrequencyData(dataArray);
      return dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
    };

    const updateFrequency = () => {
      const frequency = getAverageFrequency();
      setFrequency(frequency);
      requestAnimationFrame(updateFrequency);
    };
    updateFrequency();
  };

  const setupWorklet = async (audioContext, source) => {
    await audioContext.audioWorklet.addModule(new URL("./processor.js", import.meta.url));
    const worklet = new AudioWorkletNode(audioContext, "vad-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    source.connect(worklet);
    worklet.port.onmessage = (event) => {
      const { buffer } = event.data;
      worker.current?.postMessage({ buffer });
    };
    return worklet;
  };

  const downloadTranscript = () => {
    const content = messages
      .filter((output) => output.type === "output")
      .map(
        (output) =>
          `${formatDate(output.start)} - ${formatDate(output.end)} | ${output.message}`,
      )
      .join("\n");

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      if (audioPlayer) {
        audioPlayer.stop();
        audioPlayer.unload();
      }
      const url = URL.createObjectURL(file);
      const sound = new Howl({
        src: [url],
        format: ['mp3', 'wav', 'm4a'],
        html5: true,
        onload: () => {
          setAudioFile(file);
          setIsPlaying(true);
          sound.play();
          analyzeAudio(url);
        },
        onend: () => {
          setIsPlaying(false);
          setAudioPlayer(null);
        },
        onstop: () => {
          setIsPlaying(false);
        }
      });
      setAudioPlayer(sound);
    }
  };

  const analyzeAudio = (audioUrl) => {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    // 创建音频元素
    const audio = new Audio();
    audio.src = audioUrl;
    audio.crossOrigin = "anonymous";

    // 创建媒体源
    const source = audioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    const getAverageFrequency = () => {
      analyser.getByteFrequencyData(dataArray);
      return dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
    };

    const updateFrequency = () => {
      if (!audio.paused) {
        const frequency = getAverageFrequency();
        setFrequency(frequency);
        requestAnimationFrame(updateFrequency);
      }
    };

    // 当音频开始播放时开始分析
    audio.addEventListener('play', () => {
      audioContext.resume().then(() => {
        updateFrequency();
      });
    });

    // 播放音频
    audio.play().catch(error => {
      console.error('播放失败:', error);
      setError('音频播放失败，请重试');
    });

    return () => {
      audio.pause();
      audio.src = '';
      source.disconnect();
      analyser.disconnect();
      audioContext.close();
    };
  };

  return (
    <div className="flex flex-col items-center justify-center w-screen supports-[height:100cqh]:h-[100cqh] supports-[height:100svh]:h-[100svh] bg-gray-900">
      <motion.div
        initial={{ opacity: 1, display: "flex" }}
        animate={{ opacity: 0, display: "none" }}
        transition={{ delay: 1.5, duration: 2 }}
        className="p-2 fixed inset-0 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md z-20 text-center w-full h-full"
      >
        <h1 className="text-6xl sm:text-7xl lg:text-8xl text-white font-bold">
          Moonshine Web
        </h1>
        <h2 className="text-2xl text-white">
          Real-time in-browser speech recognition, powered by Transformers.js
        </h2>
      </motion.div>
      {error ? (
        <div className="text-center p-2">
          <div className="text-white text-4xl md:text-5xl mb-1 font-semibold">
            An error occurred
          </div>
          <div className="text-red-300 text-xl">{error}</div>
        </div>
      ) : (
        <>
          <div className="absolute top-6 right-6 z-10 flex flex-col gap-2">
            <div className="flex gap-2 bg-white/10 backdrop-blur-sm rounded p-2">
              <button
                onClick={() => setAudioSource('microphone')}
                className={`px-3 py-1 rounded ${
                  audioSource === 'microphone' 
                    ? 'bg-white text-gray-800' 
                    : 'text-white hover:bg-white/20'
                }`}
              >
                麦克风
              </button>
              <button
                onClick={() => {
                  setAudioSource('file');
                  if (audioPlayer) {
                    audioPlayer.stop();
                  }
                }}
                className={`px-3 py-1 rounded ${
                  audioSource === 'file' 
                    ? 'bg-white text-gray-800' 
                    : 'text-white hover:bg-white/20'
                }`}
              >
                音频文件
              </button>
            </div>

            {audioSource === 'file' && (
              <div className="flex flex-col gap-2">
                <label className="flex items-center justify-center px-4 py-2 bg-white rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                  <svg 
                    className="w-6 h-6 mr-2 text-gray-800" 
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  <span className="text-gray-800">上传音频</span>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>

                {audioFile && (
                  <div className="bg-white/10 backdrop-blur-sm rounded px-4 py-2 text-white">
                    正在播放: {audioFile.name}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bottom-0 absolute text-center w-full z-10 text-white overflow-hidden pb-8">
            {messages.map(({ type, message, duration }, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 25 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className={`mb-1 ${type === "output" ? "text-5xl" : "text-2xl text-green-300 font-light"}`}
              >
                <motion.div
                  initial={{ opacity: 1 }}
                  animate={
                    duration === "until_next" && index === messages.length - 1
                      ? {}
                      : {
                          opacity: 0,
                          display: "none",
                        }
                  }
                  transition={{
                    delay:
                      duration === "until_next" ? 0 : 1 + message.length / 20,
                    duration: 1,
                  }}
                >
                  {message}
                </motion.div>
              </motion.div>
            ))}
          </div>
          <Canvas camera={{ position: [0, 0, 8] }}>
            <ambientLight intensity={0.5} />
            <BloomScene frequency={frequency} />
            <AnimatedMesh
              ready={status !== null}
              active={status === "recording_start"}
              frequency={frequency}
            />
          </Canvas>
          <div className="absolute bottom-6 right-6 flex flex-col space-y-2 z-10">
            <button
              onClick={() => downloadTranscript()}
              className="w-10 h-10 bg-white rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
              title="Download Transcript"
            >
              <svg
                className="w-7 h-7 cursor-pointer text-gray-800"
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  fillRule="evenodd"
                  d="M13 11.15V4a1 1 0 1 0-2 0v7.15L8.78 8.374a1 1 0 1 0-1.56 1.25l4 5a1 1 0 0 0 1.56 0l4-5a1 1 0 1 0-1.56-1.25L13 11.15Z"
                  clipRule="evenodd"
                />
                <path
                  fillRule="evenodd"
                  d="M9.657 15.874 7.358 13H5a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-2.358l-2.3 2.874a3 3 0 0 1-4.685 0ZM17 16a1 1 0 1 0 0 2h.01a1 1 0 1 0 0-2H17Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            <button
              onClick={() =>
                window.open(
                  "https://github.com/huggingface/transformers.js-examples/tree/main/moonshine-web",
                  "_blank",
                )
              }
              className="w-10 h-10 cursor-pointer bg-white rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
              title="Source Code"
            >
              <svg
                className="w-7 h-7 text-gray-800"
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  fillRule="evenodd"
                  d="M12.006 2a9.847 9.847 0 0 0-6.484 2.44 10.32 10.32 0 0 0-3.393 6.17 10.48 10.48 0 0 0 1.317 6.955 10.045 10.045 0 0 0 5.4 4.418c.504.095.683-.223.683-.494 0-.245-.01-1.052-.014-1.908-2.78.62-3.366-1.21-3.366-1.21a2.711 2.711 0 0 0-1.11-1.5c-.907-.637.07-.621.07-.621.317.044.62.163.885.346.266.183.487.426.647.71.135.253.318.476.538.655a2.079 2.079 0 0 0 2.37.196c.045-.52.27-1.006.635-1.37-2.219-.259-4.554-1.138-4.554-5.07a4.022 4.022 0 0 1 1.031-2.75 3.77 3.77 0 0 1 .096-2.713s.839-.275 2.749 1.05a9.26 9.26 0 0 1 5.004 0c1.906-1.325 2.74-1.05 2.74-1.05.37.858.406 1.828.101 2.713a4.017 4.017 0 0 1 1.029 2.75c0 3.939-2.339 4.805-4.564 5.058a2.471 2.471 0 0 1 .679 1.897c0 1.372-.012 2.477-.012 2.814 0 .272.18.592.687.492a10.05 10.05 0 0 0 5.388-4.421 10.473 10.473 0 0 0 1.313-6.948 10.32 10.32 0 0 0-3.39-6.165A9.847 9.847 0 0 0 12.007 2Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
