/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

process.env.DEBUG='pw:api'

const { firefox } = require('playwright-firefox');
const GIFEncoder = require('gif-encoder-2')
const {createCanvas, Image} = require('canvas')
const fs = require('fs')
const knox = require('knox')
const d3 = require('d3-dsv')
const ffmpeg = require('ffmpeg')

const dataName = 'gifs.json'
const data = []

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
const sample = webcams.slice(0, 7)

async function makeZoo(cam){
	// these variables need to remain unique for each video
	let allScreenshots = []
	let page = null
	let videoDimensions = {
		width: 0,
		height: 0
	}
	
	let browser = null

	async function createGif(algorithm) {
		const {id} = cam
		return new Promise(async (resolve1, reject) => {
		//  there will always be the same range of image number files
		// so just iterate and create an array of numbers
			console.log(`Creating ${id} gif`)
  
			const [width, height] = await new Promise((resolve2) => {

			// get the file and metadata from s3 without loading it
				client.getFile(`${filePathImages}/${id}.png`, (err, res) => {
					resolve2([res.headers['x-amz-meta-width'], res.headers['x-amz-meta-height']])
				})

			}).catch(e => console.error(e))

			const canvasWidth = 500
			const canvasHeight = 281
		
  
			const encoder = new GIFEncoder(canvasWidth, canvasHeight, algorithm)
	
			const canvas = createCanvas(canvasWidth, canvasHeight)
			const ctx = canvas.getContext('2d')
			encoder.start()
			encoder.setDelay(200)

			async function processImage(file){
				console.log(`processing image ${id}`)
				await new Promise((resolveProc, reject) => {
					const image = new Image()

					image.onload = () => {
						ctx.drawImage(image, 0, 0, width, height, // source dimensions
							0, 0, canvasWidth, canvasHeight)

						ctx.getImageData(0, 0, width, height)
					

						encoder.addFrame(ctx)
						resolveProc()
				
					}

					image.onerror = () => {
						console.log('load error')
						reject()
					}
					image.src = `data:image/png;base64,${file.str}`

				}).catch((e) => console.error(e))
			}


		  async function orderImages(){
				console.log(`ordering image ${id}`)
				console.log({len: allScreenshots.length})
			
				// only process is 15 screenshots were actually taken
				if (allScreenshots.length === frameCount){
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
							reject()
						}
					})

					req.on('error', e => console.error(e))

					req.end(buffer)
				}
			  
		  }

		  await orderImages()
		
		})
	
	}


	async function collectData(){
		const timestamp = Date.now()
		cam.timestamp = timestamp

		const string = JSON.stringify(cam)

		data.push(string)
	}

	function timeout(ms){
		return new Promise(resolve => setTimeout(resolve, ms)).catch(e => console.error(e))
	}


	async function sendToS3(ss){

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
					resolve(res)
			
					return res.statusCode
				}
			})

			req.on('error', e => console.error(e))

			req.end(ss)
		})

	
	}

	async function takeScreenshots(element){
		await new Promise(async (resolveSS) => {
			console.log('take screenshots function')
			const {id} = cam			
			
			// save only the first image to AWS
			async function saveFirst(ss){
				videoDimensions =  await element.evaluate(() => ({
					width: document.documentElement.clientWidth,
					height: document.documentElement.clientHeight
				})).catch(e => console.error(`save first error: ${e}`))

				await sendToS3(ss)
			}
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
					await saveFirst(ss)
				}
			}
 
			// then resolve this promise to continue to gif-making
			resolveSS()

		}).catch((e) => console.error(`take screenshots error: ${e}`))
	
	}


	async function screenshot() {
		console.log('in screenshot function')
		

		let element = null

		try {

			// launch browser
			browser = await firefox.launch({headless: true,  args: ['--no-sandbox', 
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--single-process'] }).catch(e => console.error(`error launching browser: ${e}`))
		
			// launch a single page 
			page = await browser.newPage().catch(e => console.error(`error launching new page: ${e}`))
			// set a timeout for the page of 10 seconds
			page.setDefaultTimeout(15000)

			const {url, id, play} = cam
			console.log(`Preparing ${id} for screenshot`)

			// navigate to URL
			await page.goto(url).catch((e) => {console.error(`error navigating to page: ${e}`)})
			// await page.waitForLoadState({ waitUntil: 'domcontentloaded' }).catch((e) => {console.error(e)})

			// const full = await page.screenshot()
			// await sendToS3(full)

			// if there's a play button, click it
			if (play) {
				const buttons = play.split(', ')
				buttons.forEach(async d => {
					await page.click(`${d}`).catch((e) => console.error(`error looking for play buttons: ${e}`))
				})
			}


			// wait for video
			await page.waitForSelector('video').catch((e) => {console.error(`error waiting for video: ${e}`)})

			element = await page.$('video').catch((e) => {console.error(`error creating element: ${e}`)})

			if (element){
				// after video has loaded, then record data
				await collectData(cam) 
		
				await timeout(5000)
				// find out if video is paused
				let paused = await element.evaluate(vid => vid.paused).catch((e) => {console.error(`error evaluating paused status: ${e}`)})
				console.log({firstPause: paused})
				// if it's still paused, click the page and wait 10 seconds before checking again
				if (paused === true) {
					await page.click('body').catch((e) => {console.error(`error clicking body: ${e}`)})	
					await timeout(10000)
				}

				// check again
				paused = await element.evaluate(vid => vid.paused).catch((e) => {console.error(`error checking pause again: ${e}`)})
				console.log({paused})
				
				
				await takeScreenshots(element)
				
				
			}
	
		} catch (err) {
			console.log(`Error in screenshot function: ${err}`)
		}

		
	
	}

	async function writeData(){
		fs.writeFile(dataName, data, err => {
			if (err) return console.error('File write error:', err)
		})
	}

	// async function loopThroughCams(sample){

	// 	return new Promise(async resolve => {
	// 		for (const [index, cam] of sample.entries()){
	// 			console.log({index, cam})
	// 			const vidElement = await screenshot(cam)
	// 			await takeScreenshots(vidElement, cam.id)
	// 			await createGif('neuquant', cam.id)

	// 			if (index === sample.length - 1) {
	// 				resolve()
	// 			}
			
	// 		}

	// 	})
	
	// }

	async function getZoos(){
		// await loopThroughCams(sample)
		await screenshot()
		// await takeScreenshots(vidElement)
		if (allScreenshots.length > 0){
			await createGif('neuquant')
		
			await writeData()
		}

		if (browser) await browser.close()
		
	}

	await getZoos()
}

// run the script in parallel
// async function setup(group, cb){

// 	// iterate over script in parallel, saving the promises
// 	const finished = group.map(cam => new Promise(async (resolve) => {
// 		await makeZoo(cam)
// 		resolve()
// 		cb()
// 	}).catch(e => console.error(e))
	
// 	)

// 	return finished
	
// }

async function runBatches(){
	// run the script in batches

	try {
		for (let i = 10; i < 13; i += 1){
			const finished = webcams.slice(i, i + 1).map(async cam =>  makeZoo(cam))
			console.log(finished)

			await Promise.all(finished).catch(e => console.log(`Error in getting videos for batch ${i} - ${e}`))
		
		}	
	}
	catch (err){
		console.error(err)
	}
	
}


runBatches()

// setup()

// sample.forEach(async cam => {
// 	await makeZoo(cam)
// })
// createGif('neuquant', 6)