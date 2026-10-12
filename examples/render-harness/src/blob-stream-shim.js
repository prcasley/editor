// Browser stand-in for `blob-stream` (which needs Node's stream and util): the
// floor-plan PDF writer pipes pdfkit into it and asks for a Blob on 'finish'.
export default function blobStream() {
  const chunks = []
  const listeners = {}
  const stream = {
    writable: true,
    write(chunk) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
      return true
    },
    end(chunk) {
      if (chunk) stream.write(chunk)
      stream.emit('finish')
      stream.emit('close')
    },
    on(event, fn) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(fn)
      return stream
    },
    once(event, fn) {
      const wrapped = (...args) => {
        stream.removeListener(event, wrapped)
        fn(...args)
      }
      return stream.on(event, wrapped)
    },
    prependListener(event, fn) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].unshift(fn)
      return stream
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn)
      return stream
    },
    off(event, fn) {
      return stream.removeListener(event, fn)
    },
    emit(event, ...args) {
      for (const fn of (listeners[event] ?? []).slice()) fn(...args)
      return true
    },
    listenerCount(event) {
      return (listeners[event] ?? []).length
    },
    toBlob(type) {
      return new Blob(chunks, { type })
    },
    toBlobURL(type) {
      return URL.createObjectURL(stream.toBlob(type))
    },
  }
  return stream
}
