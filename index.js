/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

// process.env.DEBUG='pw:api'

const { firefox } = require('playwright-firefox');
const GIFEncoder = require('gif-encoder-2')
const {createCanvas, Image} = require('canvas')
const fs = require('fs')
const knox = require('knox')
const d3 = require('d3-dsv')

const filePathImages = 'zoo-cams/stills'
const filePathGIF = 'zoo-cams/output'
const frameCount = 15
const frameRange = [...Array(frameCount).keys()]



const {AWS_KEY, AWS_KEY_SECRET, AWS_BUCKET} = process.env

const client = knox.createClient({
	key: AWS_KEY,
	secret: AWS_KEY_SECRET,
	bucket: AWS_BUCKET
})

const webcams = d3.csvParse(fs.readFileSync('zoos.csv', 'utf-8'))

async function makeZoo(cam){

	async function createGif(algorithm, allScreenshots) {
		const {id} = cam
		return new Promise(async (resolve1, rejectGif) => {
			console.log(`Creating ${id} gif`)
  
			const [width, height] = await new Promise((resolve2, rejectFile) => {

			// get the file and metadata from s3 without loading it
				client.getFile(`${filePathImages}/${id}.png`, (err, res) => {
					if (err) {
						rejectFile()
						rejectGif()
						console.error(err)
					}
					else resolve2([res.headers['x-amz-meta-width'], res.headers['x-amz-meta-height']])
				})


			}).catch(e => console.error(e))

			const canvasWidth = 500
			const canvasHeight = 281


			const ratio = width / height
			let outputWidth = canvasWidth
			let outputHeight = outputWidth / ratio
			if (outputHeight > canvasHeight){
				outputHeight = canvasHeight
				outputWidth = outputHeight * ratio
			}


			// console.log({width, height, canvasWidth, canvasHeight, outputWidth, outputHeight, outputX, outputY})
			let encoder = new GIFEncoder(canvasWidth, canvasHeight, algorithm)
	
			let canvas = createCanvas(canvasWidth, canvasHeight)
			let ctx = canvas.getContext('2d')
			encoder.start()
			encoder.setDelay(200)

			async function processImage(file){
				await new Promise((resolveProc, rejectProc) => {
					const image = new Image()

					image.onload = () => {
						ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight)// , // source dimensions
						// 0, 0, canvasWidth, canvasHeight)

						ctx.getImageData(0, 0, canvasWidth, canvasHeight)

						encoder.addFrame(ctx)
						resolveProc()
					}

					image.onerror = () => {
						console.log('load error')
						rejectProc()
					}
					image.src = `data:image/png;base64,${file.str}`

				}).catch((e) => console.error(e))
			}


		  async function orderImages(){

				for (const file of allScreenshots){
					await processImage(file)
			  }

				encoder.finish()
				const buffer = encoder.out.getData()

				const req = client.put(`${filePathGIF}/${id}.gif`, {
					'Content-Type': 'image/gif',
				})

				req.on('response', (res) => {
					if (res.statusCode === 200){
						console.log('saved to %s', req.url)
						resolve1()
						allScreenshots = []
					} else {
						console.log(`Status: ${res.statusCode}`)
						rejectGif()
					}
				})

				req.on('error', e => {console.error(`Error in saving gif: ${e}`)
					rejectGif()})

				req.end(buffer)

				// set back to nothing for garbage collecting
				encoder = null
				canvas = null
				ctx = null

			  
		  }

		  await orderImages()
		  // await collectGarbage()
		
		}).catch(err => console.error(`Error with making gif promise: ${err}`))
	
	}


	// Create a promise that rejects in <ms> milliseconds
	function promiseTimeout(ms, promise){

		// Create a promise that rejects in <ms> milliseconds
		const timeout = new Promise((resolve, reject) => {
		  const id = setTimeout(() => {
				clearTimeout(id);
				reject(`Timed out in ${ms} ms.`)
		  }, ms)
		})
	  
		// Returns a race between our timeout and the passed in promise
		return Promise.race([
		  promise,
		  timeout
		])
	  }


	async function sendToS3(ss, videoDimensions){

		const {id} = cam

		return new Promise((resolve, reject) => {
		// write screenshot to AWS
			const req = client.put(`${filePathImages}/${id}.png`, {
				'Content-Type': 'image/png',
				'x-amz-meta-height': videoDimensions.height,
				'x-amz-meta-width': videoDimensions.width
			})

			req.on('response', (res) => {
				if (res.statusCode === 200){
					console.log('saved to %s', req.url)
					resolve()
			
					return res.statusCode
				} 
				console.error(`Error sending to s3: ${res.statusCode}`)
				reject()
				return null
			})

			req.on('error', e => {
				reject(e)
				console.error(e)
			})

			req.end(ss)
		}).catch(err => console.error(`Error sending to S3 promise: ${err}`))

	
	}

	async function takeScreenshots(element){
		return new Promise(async (resolveSS) => {
			const {id} = cam			
			
			// save only the first image to AWS
			async function saveFirst(ss){

				const videoDimensions = await element.evaluate(() => ({
					width: document.documentElement.clientWidth,
					height: document.documentElement.clientHeight
				})).catch(e => console.error(`save first error: ${e}`))

				await sendToS3(ss, videoDimensions)
			}
			
			const allScreenshots = []
			// eslint-disable-next-line no-restricted-syntax
			for (const frame of frameRange){
	
				// eslint-disable-next-line no-await-in-loop
				const ss = await element.screenshot({path: ''}).catch((e) => {
					console.error(`error in playwright screenshot: ${e}`); 
					return('') })

				const str = ss.toString('base64')

				// save all ss data locally 
				
				allScreenshots.push({index: frame, str, ss, id})

				// run function to just save first image
				// all others are still saved locally
				if (frame === 0){
					await saveFirst(ss).catch(err => console.error(`Error saving first: ${err}`))
				}
			}
 
			// then resolve this promise to continue to gif-making
			resolveSS(allScreenshots)

		}).catch((e) => console.error(`take screenshots error: ${e}`))
	}

	async function checkPlayButtons(page, play){
		const buttons = play.split(', ')
		console.log('trying to click buttons')
		for (const [index, btn] of buttons.entries()){
			await page.click(`${btn}`, {timeout: 10000}).catch(e => {console.error(`error clicking play buttons: ${e}`)})
		}
	}


	async function screenshot(page) {
		return new Promise(async (resolve, reject) => {
			let element = null

			// set a timeout for the page of 10 seconds
			await page.setDefaultTimeout(20000)
			page.on('crash', error => reject(error))

			const {url, id, play} = cam
			console.log(`Preparing ${id} for screenshot`)

			await page.setViewportSize({
				width: 640,
				height: 480,
			  })

			// navigate to URL
			await page.goto(url, {waitUntil: 'networkidle'}).catch((e) => {console.error(`error navigating to page: ${e}`)})

			// if there's a play button, click it
			if (play) await checkPlayButtons(page, play) 

			// wait for video
			// await page.waitForSelector('video').catch((e) => {console.error(`error waiting for video: ${e}`)})

			element = await page.$$('video', el => {
				console.log({el})
				// play video element
				el.play()
				// return just the video element
				return el
			}).catch((e) => {console.error(`error creating element: ${e}`)})
			

			if (element){
				await page.waitForTimeout(5000)
				const vidEl = await page.$('video').catch((e) => {console.error(`error finding element: ${e}`)})
				await takeScreenshots(vidEl)
					.then(response => resolve(response))
					.catch(e => console.error(`Error with taking screenshots function: ${e}`))
				// resolve(allScreenshots)
			} else reject(console.error('Can\'t find video element on page'))
		})
	}


	async function getZoos(){
		return new Promise(async (resolve, reject) => {
			// launch browser
			const browser = await firefox.launch({headless: true,  args: ['--no-sandbox']}).catch(e => console.error(`error launching browser: ${e}`))
			// launch a single page 
			const page = await browser.newPage({_recordVideos: true}).catch(e => console.error(`error launching new page: ${e}`))
			await screenshot(page)
				.then(async response => {
					await browser.close().catch(e => console.error(`Error closing browser: ${e}`))
					if (response.length > 0){
						await createGif('neuquant', response).catch(e => console.error(`Error creating gif: ${e}`))
						resolve()
					}
				}).catch(async e => {
					console.error(`Error taking screenshot in getzoos function: ${e}`)
					await browser.close().catch(console.error(`Error closing browser: ${e}`))
					reject()
				})
		})
	}
	await getZoos().catch(e => console.error(`Error getting zoos: ${e}`))
}


// async function runBatches(){
// 	// run the script in batches

// 	try {
// 		// for (let i = 0; i < webcams.length; i += 1){
// 		// const finished = webcams.slice(i, i + 1).map(async cam =>  makeZoo(cam))
// 		const sloth = webcams.filter(d => d.id === '67')[0]
// 		console.log({sloth})
	
// 		makeZoo(sloth)
// 		// await Promise.all(finished).catch(e => console.log(`Error in getting videos for batch ${i} - ${e}`))
		
// 		// }	
// 	}
// 	catch (err){
// 		console.error(err)
// 	}
	
// }


// runBatches()

// automatically run this
(async function loopThroughCams(){
	const sub = webcams.slice(43, 46)
	return new Promise(async resolve => {
		for (const [index, cam] of sub.entries()){
			await makeZoo(cam).catch(e => console.error(`Error making zoos: ${e}`))

			if (index === webcams.length - 1) resolve()
		}
	}).catch(err => console.error(`Issue looping through cams: ${err}`))
})()